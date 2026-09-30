module.exports = ({ config }) => {
  const production = process.env.EAS_BUILD_PROFILE === "production";
  const apiUrl = process.env.EXPO_PUBLIC_API_URL;
  if (production && (!apiUrl || !apiUrl.startsWith("https://"))) {
    throw new Error("Production builds require an HTTPS EXPO_PUBLIC_API_URL.");
  }
  return {
    ...config,
    plugins: [
      ...(config.plugins ?? []),
      ["./plugins/local-network.js", { allowHttp: !production }],
    ],
  };
};
