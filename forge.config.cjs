module.exports = {
  outDir: process.env.PI_HUB_PACKAGE_OUT || 'dist/packages',
  packagerConfig: {
    name: 'Pi Hub',
    executableName: 'Pi Hub',
    appBundleId: 'local.pi-hub.desktop',
    appCategoryType: 'public.app-category.developer-tools',
    extendInfo: {
      NSAppleEventsUsageDescription: 'Pi Hub 需要控制 Terminal 和 Ghostty，以启动 Pi 会话并定位已有会话。',
    },
    asar: { unpack: '**/*.node' },
    ignore: [
      /^\/(?!dist(?:\/|$)|node_modules(?:\/|$)|package\.json$)/,
      // Only runtime directories belong in the app; never recursively include packaged apps.
      /^\/dist\/(?!desktop(?:\/|$)|renderer(?:\/|$)|terminal(?:\/|$))/,
    ],
  },
  rebuildConfig: {},
};
