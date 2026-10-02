import { render } from "solid-js/web"
import { App } from "./app"
import { PROJECT_KEY } from "./shell"
import "./index.css"

// Read the remembered project before the first render so home never flashes a different project.
void chrome.storage.local.get(PROJECT_KEY).then((stored) => {
  const project = stored[PROJECT_KEY]
  render(() => <App project={typeof project === "string" ? project : undefined} />, document.getElementById("root")!)
})
