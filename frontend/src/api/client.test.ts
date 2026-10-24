import { describe, expect, it } from "vitest";
import { errorResponse, htmlResponse, jsonResponse, mockFetch, mockNetworkError } from "../test/mockApi";
import { API_BASE_URL, api, createApiClient } from "./client";

describe("api client", () => {
  it("has an empty default base URL", () => {
    expect(API_BASE_URL).toBe("");
  });

  it("requests GET /api/health at the path /api/health", async () => {
    const fetchMock = mockFetch(() => jsonResponse({ status: "ok" }));

    await createApiClient({ fetch: fetchMock }).GET("/api/health");

    expect(fetchMock.mock.calls[0][0].url).toBe(`${location.origin}/api/health`);
  });

  it("parses a 200 body into data", async () => {
    mockFetch(() => jsonResponse({ status: "ok" }));

    const { data, error } = await api.GET("/api/health");

    expect(data).toEqual({ status: "ok" });
    expect(error).toBeUndefined();
  });

  it("parses a 404 in the shared error shape into error.error", async () => {
    mockFetch(() => errorResponse(404, "not_found", "No such thing"));

    const { data, error } = await api.GET("/api/health");

    expect(data).toBeUndefined();
    expect(error).toMatchObject({ error: { code: "not_found", message: "No such thing" } });
  });

  it("parses a documented 500 in the shared error shape into error.error", async () => {
    mockFetch(() => errorResponse(500, "internal_error", "Something went wrong"));

    const { error, response } = await api.GET("/api/health");

    expect(response.status).toBe(500);
    expect(error?.error.code).toBe("internal_error");
    expect(error?.error.message).toBe("Something went wrong");
  });

  it("returns the raw HTML text as error for a 502 with an HTML body", async () => {
    mockFetch(() => htmlResponse(502, "<html>Bad Gateway</html>"));

    const { data, error, response } = await api.GET("/api/health");

    expect(response.status).toBe(502);
    expect(data).toBeUndefined();
    expect(error).toBe("<html>Bad Gateway</html>");
  });

  it("rejects with a TypeError when fetch fails", async () => {
    mockNetworkError();

    await expect(api.GET("/api/health")).rejects.toBeInstanceOf(TypeError);
  });

  it("does not send credentials: include", async () => {
    const fetchMock = mockFetch(() => jsonResponse({ status: "ok" }));

    await api.GET("/api/health");

    expect(fetchMock.mock.calls[0][0].credentials).not.toBe("include");
  });
});
