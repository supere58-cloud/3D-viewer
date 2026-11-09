import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.mineviewer.app',
  appName: 'Mine Viewer',
  webDir: 'dist',
  android: {
    // No mixed content, no remote debugging in release builds.
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
  },
  ios: {
    contentInset: 'never',
  },
};

export default config;
