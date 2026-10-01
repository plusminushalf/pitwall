import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { startAnalytics } from "./analytics";
import { App } from "./App";
import { DesktopOnly, isPhone } from "./components/DesktopOnly";
import "./index.css";

startAnalytics();

// On a phone the app doesn't start at all: no library, no downloads.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isPhone() ? <DesktopOnly /> : <App />}
  </StrictMode>,
);
