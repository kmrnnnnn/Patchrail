import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connection: vi.fn(),
  getSession: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("next/server", () => ({ connection: mocks.connection }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/server/session", () => ({ getSession: mocks.getSession }));

import LoginPage from "@/app/login/page";

describe("login page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connection.mockResolvedValue(undefined);
    mocks.redirect.mockImplementation((destination: string) => {
      throw new Error(`redirect:${destination}`);
    });
  });

  it("redirects an authenticated session before rendering the login form", async () => {
    mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });

    await expect(LoginPage()).rejects.toThrow("redirect:/app");
    expect(mocks.redirect).toHaveBeenCalledOnce();
    expect(mocks.redirect).toHaveBeenCalledWith("/app");
  });

  it("renders the login page when no session exists", async () => {
    mocks.getSession.mockResolvedValue(null);

    const page = await LoginPage();

    expect(page.type).toBe("main");
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
