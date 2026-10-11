import React from "react";
import { createRoot } from "react-dom/client";
import "@sa/index.css";
import "./tokens.app.css";
import "./i18n";
import { App } from "./App";
import { applyTheme, readStoredTheme } from "./theme";

// 描画前に反映して、ダークの人にライトが一瞬映るのを防ぐ
applyTheme(readStoredTheme());

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
