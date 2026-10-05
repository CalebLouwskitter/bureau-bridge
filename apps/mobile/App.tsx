import React from "react";
import { AppearanceProvider } from "./src/AppearanceProvider";
import { BureauApp } from "./src/BureauApp";

export default function App() {
  return (
    <AppearanceProvider>
      <BureauApp />
    </AppearanceProvider>
  );
}
