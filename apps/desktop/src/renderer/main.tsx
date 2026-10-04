import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { createDesktopStore } from "./store.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing app root");
let selection: { workspaceId?: string; sessionId?: string } | undefined;
try {
  const saved = JSON.parse(
    localStorage.getItem("moodcode.selection.v1") ?? "null",
  ) as unknown;
  if (
    saved &&
    typeof saved === "object" &&
    "workspaceId" in saved &&
    typeof saved.workspaceId === "string"
  )
    selection = {
      workspaceId: saved.workspaceId,
      ...("sessionId" in saved && typeof saved.sessionId === "string"
        ? { sessionId: saved.sessionId }
        : {}),
    };
} catch {
  /* Invalid UI preference does not affect engine history. */
}
const api = window.moodcode;
if (api) {
  const store = createDesktopStore(api, selection);
  createRoot(root).render(<App store={store} />);
  void store.initialize();
  window.addEventListener(
    "beforeunload",
    () => {
      void store.stop();
    },
    { once: true },
  );
} else
  createRoot(root).render(
    <main className="standalone">
      <div className="brand-mark">m</div>
      <h1>Moodcode</h1>
      <p>데스크톱 앱에서 열어주세요.</p>
      <p>이 화면은 앱의 로컬 엔진에 연결되어 동작해요.</p>
    </main>,
  );
