export type Appearance = "light" | "dark";

// Semantic colours are shared by Tamagui and native system surfaces.
export const palettes = {
  light: {
    background: "#F4F7F5",
    surface: "#FFFFFF",
    surfaceMuted: "#EDF2EF",
    borderColor: "#DCE5DF",
    color: "#182C24",
    muted: "#576A60",
    accent: "#8DE4BD",
    accentStrong: "#236647",
    accentSoft: "#DFF5E8",
    onAccent: "#122E22",
    success: "#206344",
    successSurface: "#E0F4E8",
    warning: "#79520F",
    warningSurface: "#FFF1D3",
    danger: "#A53238",
    dangerSurface: "#FCE8E9",
  },
  dark: {
    background: "#050505",
    surface: "#141414",
    surfaceMuted: "#1E1E1E",
    borderColor: "#343434",
    color: "#F0F5F2",
    muted: "#AFBBB4",
    accent: "#8DE4BD",
    accentStrong: "#8DE4BD",
    accentSoft: "#193027",
    onAccent: "#122E22",
    success: "#8DE4BD",
    successSurface: "#193027",
    warning: "#EAC578",
    warningSurface: "#332A19",
    danger: "#FFAFB3",
    dangerSurface: "#361D20",
  },
} as const;

export type Palette = (typeof palettes)[Appearance];
