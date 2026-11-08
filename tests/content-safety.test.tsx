import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("../src/importers", () => ({
  monaco: {},
  getDocument: vi.fn(),
  pdfOptions: {},
}));
vi.mock("../src/api", () => ({ desktop: false, api: {} }));
import { InlineText } from "../src/components";
afterEach(cleanup);

it("displays hostile document and AI text without creating executable elements", () => {
  const text =
    '<script>alert(1)</script><img src=x onerror="alert(2)"> [run](javascript:alert(3))';
  const { container } = render(<InlineText text={text} />);
  expect(container.textContent).toBe(text);
  expect(container.querySelector("script,img,a,iframe")).toBeNull();
});

it("makes only supplied source IDs clickable", () => {
  const follow = vi.fn();
  render(
    <InlineText
      text="[ref:known] [ref:forged]"
      onReference={follow}
      refs={[
        {
          id: "known",
          segmentId: "known",
          revision: "v1",
          text: "Source",
          location: { page: 2 },
        },
      ]}
    />,
  );
  const links = screen.getAllByRole("button", { name: "参照 ↗" });
  expect(links).toHaveLength(1);
  links[0].click();
  expect(follow).toHaveBeenCalledWith("known");
  expect(screen.getByText("[ref:forged]")).toBeDefined();
});
