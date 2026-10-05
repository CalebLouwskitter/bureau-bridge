import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import * as SystemUI from "expo-system-ui";
import { TamaguiProvider } from "tamagui";
import { tamaguiConfig } from "../tamagui.config";
import { palettes, type Appearance, type Palette } from "./palettes";

const KEY = "bureau-appearance";
const AppearanceContext = createContext<{
  mode: Appearance;
  palette: Palette;
  toggle: () => void;
}>({ mode: "light", palette: palettes.light, toggle: () => {} });

export function AppearanceProvider({ children }: React.PropsWithChildren) {
  const [mode, setMode] = useState<Appearance>("light");
  const selected = useRef(false);
  const current = useRef<Appearance>("light");
  const writes = useRef(Promise.resolve());

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(KEY)
      .then((saved) => {
        if (
          active &&
          !selected.current &&
          (saved === "light" || saved === "dark")
        ) {
          current.current = saved;
          setMode(saved);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const palette = palettes[mode];
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(palette.background).catch(() => {});
    if (Platform.OS === "web") {
      document.documentElement.style.colorScheme = mode;
      document.body.style.backgroundColor = palette.background;
    }
  }, [mode, palette.background]);

  function toggle() {
    selected.current = true;
    const next = current.current === "light" ? "dark" : "light";
    current.current = next;
    setMode(next);
    // Serialize rapid taps so the last visible choice is also the saved choice.
    writes.current = writes.current
      .then(() => AsyncStorage.setItem(KEY, next))
      .catch(() => {});
  }

  return (
    <TamaguiProvider config={tamaguiConfig} defaultTheme={mode}>
      <SafeAreaProvider>
        <AppearanceContext.Provider value={{ mode, palette, toggle }}>
          <StatusBar style={mode === "light" ? "dark" : "light"} />
          {children}
        </AppearanceContext.Provider>
      </SafeAreaProvider>
    </TamaguiProvider>
  );
}

export const useAppearance = () => useContext(AppearanceContext);
