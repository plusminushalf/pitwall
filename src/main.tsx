import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { startAnalytics } from "./analytics";
import { App } from "./App";
import "./index.css";

startAnalytics();

const root = document.getElementById("root");
if (!root) throw new Error("no #root");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
