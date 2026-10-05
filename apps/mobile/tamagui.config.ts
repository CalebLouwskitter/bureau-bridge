import { defaultConfig } from "@tamagui/config/v5";
import { createTamagui } from "tamagui";
import { palettes } from "./src/palettes";

function theme(mode: "light" | "dark") {
  const p = palettes[mode];
  return {
    ...defaultConfig.themes[mode],
    ...p,
    backgroundHover: p.surfaceMuted,
    backgroundPress: p.accentSoft,
    backgroundFocus: p.surfaceMuted,
    borderColorHover: p.accentStrong,
    borderColorPress: p.accentStrong,
    borderColorFocus: p.accentStrong,
    colorHover: p.color,
    colorPress: p.color,
    colorFocus: p.color,
    placeholderColor: p.muted,
    outlineColor: p.accentStrong,
  };
}

export const tamaguiConfig = createTamagui({
  ...defaultConfig,
  themes: { light: theme("light"), dark: theme("dark") },
  settings: {
    ...defaultConfig.settings,
    // Appearance is an explicit, persisted choice; first launch is always light.
    fastSchemeChange: false,
    shouldAddPrefersColorThemes: false,
    onlyAllowShorthands: false,
  },
});

type AppConfig = typeof tamaguiConfig;
declare module "tamagui" {
  interface TamaguiCustomConfig extends AppConfig {}
}
