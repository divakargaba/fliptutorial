import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { ReadinessCheck } from "./readiness-check";

test("checks app liveness without claiming cloud access", async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: "ok" }) });
  vi.stubGlobal("fetch", fetcher);
  render(<ReadinessCheck />);
  await userEvent.click(screen.getByRole("button", { name: "Check local app" }));
  expect(await screen.findByText(/App server is responding/)).toHaveTextContent("Cloud connections are not checked.");
  expect(fetcher).toHaveBeenCalledWith("/api/health", expect.objectContaining({ signal: expect.any(AbortSignal) }));
});

test.each(["network", "http", "invalid body"])("recovers from a %s failure", async kind => {
  const fetcher = kind === "network" ? vi.fn().mockRejectedValue(new Error("offline")) : vi.fn().mockResolvedValue({ ok: kind !== "http", json: async () => ({ status: "failed" }) });
  vi.stubGlobal("fetch", fetcher);
  render(<ReadinessCheck />);
  await userEvent.click(screen.getByRole("button", { name: "Check local app" }));
  expect(await screen.findByText(/Could not reach the app server/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Check local app" })).toBeEnabled();
});
