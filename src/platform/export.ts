/**
 * Hands a generated text file to the user without any network use:
 * the system share sheet in the native apps and on touch browsers, a plain
 * download on desktop browsers.
 */
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { isNative } from './native';

export type ExportResult = 'shared' | 'downloaded' | 'cancelled' | 'failed';

export async function exportTextFile(name: string, text: string, mime: string): Promise<ExportResult> {
  if (isNative) {
    try {
      const { uri } = await Filesystem.writeFile({ path: name, data: text, directory: Directory.Cache, encoding: Encoding.UTF8 });
      await Share.share({ title: name, files: [uri] });
      return 'shared';
    } catch (e) {
      return /cancel/i.test(String((e as { message?: string })?.message ?? e)) ? 'cancelled' : 'failed';
    }
  }
  const touch = window.matchMedia('(pointer: coarse)').matches;
  try {
    const file = new File([text], name, { type: mime });
    if (touch && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: name });
      return 'shared';
    }
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') return 'cancelled';
    // Fall through to a download.
  }
  try {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.className = 'offscreen';
    document.body.append(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10000);
    return 'downloaded';
  } catch {
    return 'failed';
  }
}
