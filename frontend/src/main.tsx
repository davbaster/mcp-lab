import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import App from "./App";
import { installConsoleBuffer } from "./feedback/consoleBuffer";
import "./styles/tokens.css";
import "./styles/global.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Root element #root not found");
}

// Before the first render, so an error while it renders is kept too.
installConsoleBuffer();

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
