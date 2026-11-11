import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const extract = readFileSync(resolve("src-tauri/src/browser_dom.js"), "utf8");
const write = new Function(
  `return (${readFileSync(resolve("src-tauri/src/browser_apply.js"), "utf8")})`,
)();
afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

it("writes translations as text, preserves sentence whitespace and restores only owned nodes", () => {
  document.body.innerHTML =
    '<p id="prose">  The first sentence.  The second sentence. </p><p id="changed">Site content.</p><p id="replaced">Another paragraph.</p><pre>Untouched code.</pre><input value="Untouched input.">';
  Object.defineProperty(Element.prototype, "checkVisibility", {
    configurable: true,
    value: () => true,
  });
  const page = new Function(`return ${extract}`)();
  const prose = page.segments.filter((segment) => segment.block === 0);
  expect(prose.map((segment) => segment.text)).toEqual([
    "The first sentence.",
    "The second sentence.",
  ]);
  const update = '<img src=x onerror="throw 1"><script>throw 2</script>';
  write.call(page, [{ id: prose[0].id, text: update }], false);
  expect(document.querySelector("#prose").textContent).toBe(
    `  ${update}  The second sentence. `,
  );
  expect(document.querySelector("img,script")).toBeNull();
  document.querySelector("#changed").firstChild.data =
    "The site changed this text.";
  document.querySelector("#replaced").outerHTML =
    '<p id="replaced">A replacement from the site.</p>';
  write.call(page, [], false);
  expect(document.querySelector("#prose").textContent).toBe(
    "  The first sentence.  The second sentence. ",
  );
  expect(document.querySelector("#changed").textContent).toBe(
    "The site changed this text.",
  );
  expect(document.querySelector("#replaced").textContent).toBe(
    "A replacement from the site.",
  );
  expect(document.querySelector("pre").textContent).toBe("Untouched code.");
  expect(document.querySelector("input").value).toBe("Untouched input.");
});

it("reports partial extraction when a prose node exceeds the capture limit", () => {
  document.body.append(
    document.createElement("p"),
    document.createElement("p"),
  );
  document.body.children[0].textContent = "a".repeat(14001);
  document.body.children[1].textContent = "Readable sentence.";
  Object.defineProperty(Element.prototype, "checkVisibility", {
    configurable: true,
    value: () => true,
  });
  const page = new Function(`return ${extract}`)();
  expect(page.segments.map((segment) => segment.text)).toEqual([
    "Readable sentence.",
  ]);
  expect(page.truncated).toBe(true);
});
