import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/barlow-condensed/500.css";
import "@fontsource/barlow-condensed/600.css";
import "@fontsource/barlow-condensed/700.css";
import "@fontsource/barlow-condensed/700-italic.css";
import "@fontsource/barlow-condensed/800-italic.css";
import "@fontsource/barlow-condensed/900-italic.css";
import "@fontsource/jetbrains-mono/500.css";
import { startAnalytics } from "../analytics";
import { App } from "./App";
import "./page.css";

startAnalytics();

const root = document.getElementById("root");
if (!root) throw new Error("no #root");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
