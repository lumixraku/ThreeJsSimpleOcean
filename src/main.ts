import { OceanApplication } from "./app/OceanApplication";

const root = document.body;
const app = new OceanApplication(root);
void app.init().catch((err) => {
  console.error(err);
  const pre = document.createElement("pre");
  pre.textContent = String(err);
  pre.style.color = "#fff";
  pre.style.padding = "12px";
  root.appendChild(pre);
});
