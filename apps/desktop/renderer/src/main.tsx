import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/newsreader";
import { App } from "./App";
import { OverlayApp } from "./OverlayApp";
import "./styles.css";

const overlay = window.location.hash === "#overlay";
document.documentElement.classList.toggle("overlay-document", overlay);
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{overlay ? <OverlayApp /> : <App />}</React.StrictMode>,
);
