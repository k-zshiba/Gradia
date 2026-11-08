import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./style.css";
class StartupBoundary extends React.Component<
  React.PropsWithChildren,
  { error: string | null }
> {
  state: { error: string | null } = { error: null };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  render() {
    if (this.state.error)
      return (
        <main className="boot-guide" role="alert">
          <h1>画面を表示できませんでした</h1>
          <p>{this.state.error}</p>
          <button onClick={() => window.location.reload()}>再読み込み</button>
        </main>
      );
    return this.props.children;
  }
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <StartupBoundary>
      <App />
    </StartupBoundary>
  </React.StrictMode>,
);
