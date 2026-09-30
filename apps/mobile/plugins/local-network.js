const { withAndroidManifest, withInfoPlist } = require("expo/config-plugins");
module.exports = (config, { allowHttp = false } = {}) => {
  config = withAndroidManifest(config, (mod) => {
    mod.modResults.manifest.application[0].$["android:usesCleartextTraffic"] =
      String(allowHttp);
    return mod;
  });
  return withInfoPlist(config, (mod) => {
    mod.modResults.NSAppTransportSecurity = {
      NSAllowsArbitraryLoads: allowHttp,
    };
    return mod;
  });
};
