package com.mineviewer.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;

import androidx.activity.result.ActivityResult;

import androidx.core.content.IntentCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Receives files from "Open with" (ACTION_VIEW) and "Share" (ACTION_SEND /
 * ACTION_SEND_MULTIPLE). Each file is copied into the app's private cache,
 * because the permission on a shared content:// URI is short-lived, and the
 * web layer is told the path. The web layer reads the copy through the
 * Filesystem plugin and then calls release() to delete it.
 *
 * Nothing here touches the network.
 */
@CapacitorPlugin(name = "FileIntake")
public class FileIntakePlugin extends Plugin {
    private static final String CONSUMED = "com.mineviewer.app.CONSUMED";
    private static final String DIR = "intake";

    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Object lock = new Object();
    private final List<JSObject> pending = new ArrayList<>();
    private int pendingFailed = 0;
    private boolean webReady = false;

    @Override
    public void load() {
        // Copies left over from a previous run that was killed mid-import.
        io.execute(() -> deleteChildren(intakeDir()));
        handleIntent(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        handleIntent(intent);
    }

    @Override
    protected void handleOnDestroy() {
        io.shutdown();
        super.handleOnDestroy();
    }

    private File intakeDir() {
        File dir = new File(getContext().getCacheDir(), DIR);
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        return dir;
    }

    private static void deleteChildren(File dir) {
        File[] files = dir.listFiles();
        if (files == null) return;
        for (File f : files) {
            //noinspection ResultOfMethodCallIgnored
            f.delete();
        }
    }

    private void handleIntent(Intent intent) {
        if (intent == null || intent.getBooleanExtra(CONSUMED, false)) return;
        String action = intent.getAction();
        Set<Uri> uris = new LinkedHashSet<>();
        if (Intent.ACTION_VIEW.equals(action)) {
            if (intent.getData() != null) uris.add(intent.getData());
        } else if (Intent.ACTION_SEND.equals(action)) {
            Uri u = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri.class);
            if (u != null) uris.add(u);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> list = IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri.class);
            if (list != null) uris.addAll(list);
        } else {
            return;
        }
        ClipData clip = intent.getClipData();
        if (clip != null) {
            for (int i = 0; i < clip.getItemCount(); i++) {
                Uri u = clip.getItemAt(i).getUri();
                if (u != null) uris.add(u);
            }
        }
        // The activity may be recreated with the same intent; import it once.
        intent.putExtra(CONSUMED, true);
        if (uris.isEmpty()) return;

        final List<Uri> work = new ArrayList<>(uris);
        io.execute(() -> {
            List<JSObject> files = new ArrayList<>();
            int failed = 0;
            for (Uri uri : work) {
                JSObject f = copy(uri);
                if (f != null) files.add(f);
                else failed++;
            }
            deliver(files, failed);
        });
    }

    private String displayName(Uri uri) {
        String name = null;
        if (ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) {
            try (Cursor c = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
                if (c != null && c.moveToFirst() && !c.isNull(0)) name = c.getString(0);
            } catch (Exception ignored) {
                // Some providers do not support queries; fall back to the path.
            }
        }
        if (name == null || name.isEmpty()) name = uri.getLastPathSegment();
        if (name == null || name.isEmpty()) name = "file";
        int slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf(':'));
        return slash >= 0 && slash < name.length() - 1 ? name.substring(slash + 1) : name;
    }

    private JSObject copy(Uri uri) {
        return copy(uri, displayName(uri));
    }

    private JSObject copy(Uri uri, String name) {
        File out = new File(intakeDir(), UUID.randomUUID().toString());
        long size = 0;
        try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
            if (in == null) return null;
            try (OutputStream os = new FileOutputStream(out)) {
                byte[] buf = new byte[1 << 20];
                int n;
                while ((n = in.read(buf)) > 0) {
                    os.write(buf, 0, n);
                    size += n;
                }
            }
        } catch (Exception e) {
            //noinspection ResultOfMethodCallIgnored
            out.delete();
            return null;
        }
        JSObject f = new JSObject();
        f.put("path", Uri.fromFile(out).toString());
        f.put("name", name);
        f.put("size", size);
        return f;
    }

    private static JSObject payload(List<JSObject> files, int failed) {
        JSArray arr = new JSArray();
        for (JSObject f : files) arr.put(f);
        JSObject data = new JSObject();
        data.put("files", arr);
        data.put("failed", failed);
        return data;
    }

    private void deliver(List<JSObject> files, int failed) {
        synchronized (lock) {
            if (!webReady) {
                pending.addAll(files);
                pendingFailed += failed;
                return;
            }
        }
        notifyListeners("files", payload(files, failed));
    }

    // --- whole folder -----------------------------------------------------

    private static final int MAX_FOLDER_FILES = 500;
    private static final int MAX_FOLDER_DEPTH = 8;

    private static boolean isModelFile(String name) {
        String n = name.toLowerCase(Locale.ROOT);
        return n.endsWith(".dxf") || n.endsWith(".glb") || n.endsWith(".obj") || n.endsWith(".stl");
    }

    /** Opens the system folder picker; resolves with every supported file in the chosen folder. */
    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        startActivityForResult(call, intent, "folderPicked");
    }

    @ActivityCallback
    private void folderPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            JSObject r = payload(new ArrayList<>(), 0);
            r.put("skipped", 0);
            r.put("cancelled", true);
            call.resolve(r);
            return;
        }
        final Uri tree = data.getData();
        io.execute(() -> {
            List<JSObject> files = new ArrayList<>();
            int[] counts = new int[2]; // [failed, skipped]
            try {
                walk(tree, DocumentsContract.getTreeDocumentId(tree), 0, files, counts);
            } catch (Exception e) {
                counts[0]++;
            }
            JSObject r = payload(files, counts[0]);
            r.put("skipped", counts[1]);
            r.put("cancelled", false);
            call.resolve(r);
        });
    }

    private void walk(Uri tree, String documentId, int depth, List<JSObject> files, int[] counts) {
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, documentId);
        List<String[]> entries = new ArrayList<>();
        String[] columns = {
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE
        };
        try (Cursor c = getContext().getContentResolver().query(children, columns, null, null, null)) {
            while (c != null && c.moveToNext()) entries.add(new String[] { c.getString(0), c.getString(1), c.getString(2) });
        }
        for (String[] e : entries) {
            String name = e[1] == null ? "" : e[1];
            if (DocumentsContract.Document.MIME_TYPE_DIR.equals(e[2])) {
                if (depth < MAX_FOLDER_DEPTH) walk(tree, e[0], depth + 1, files, counts);
            } else if (isModelFile(name) && files.size() < MAX_FOLDER_FILES) {
                JSObject f = copy(DocumentsContract.buildDocumentUriUsingTree(tree, e[0]), name);
                if (f != null) files.add(f);
                else counts[0]++;
            } else {
                counts[1]++;
            }
        }
    }

    /** Called once by the web layer after it has subscribed to "files". */
    @PluginMethod
    public void getPending(PluginCall call) {
        JSObject data;
        synchronized (lock) {
            webReady = true;
            data = payload(pending, pendingFailed);
            pending.clear();
            pendingFailed = 0;
        }
        call.resolve(data);
    }

    /** Deletes cache copies. Only files inside the intake directory are touched. */
    @PluginMethod
    public void release(PluginCall call) {
        JSArray paths = call.getArray("paths");
        if (paths != null) {
            try {
                String root = intakeDir().getCanonicalPath() + File.separator;
                for (int i = 0; i < paths.length(); i++) {
                    Uri u = Uri.parse(paths.getString(i));
                    if (u.getPath() == null) continue;
                    File f = new File(u.getPath()).getCanonicalFile();
                    if (f.getPath().startsWith(root)) {
                        //noinspection ResultOfMethodCallIgnored
                        f.delete();
                    }
                }
            } catch (Exception ignored) {
                // Best effort; leftovers are removed at the next start.
            }
        }
        call.resolve();
    }
}
