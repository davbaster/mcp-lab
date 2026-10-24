import { cleanup, render, screen } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, expect, it } from "vitest";
import { jsonResponse, mockFetch } from "../test/mockApi";
import { api } from "./client";

// The client module is imported above, before any stub exists, like a real page would be.
function HealthStatus() {
  const [status, setStatus] = useState("loading");
  useEffect(() => {
    void api.GET("/api/health").then(({ data }) => setStatus(data ? data.status : "failed"));
  }, []);
  return <p>{status}</p>;
}

afterEach(cleanup);

it("gets the stubbed response when the stub is installed after the client module loaded", async () => {
  mockFetch(() => jsonResponse({ status: "ok" }));

  render(<HealthStatus />);

  expect(await screen.findByText("ok")).toBeTruthy();
});
