import { expect, test, vi } from "vitest";

test.each([
  ["", ""],
  ["https://example.supabase.co", ""],
  ["", "sb_publishable_example"],
])("does not initialize a client with incomplete configuration (%s, %s)", async (url, key) => {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", url);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", key);
  const { supabase } = await import("./client");
  expect(supabase).toBeNull();
});

test("uses the configured project and publishable key for Data API requests", async () => {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_example");
  const request = vi.fn().mockResolvedValue(new Response('[{"id":1}]', {
    headers: { "Content-Type": "application/json" },
  }));
  vi.stubGlobal("fetch", request);
  const { supabase } = await import("./client");
  const result = await supabase!.from("demo_items").select("id");
  expect(result.error).toBeNull();
  expect(result.data).toEqual([{ id: 1 }]);
  const [url, options] = request.mock.calls[0];
  expect(String(url)).toBe("https://example.supabase.co/rest/v1/demo_items?select=id");
  expect(new Headers(options.headers).get("apikey")).toBe("sb_publishable_example");
});
