/**
 * Tests for agent tool definitions and stage-based filtering.
 */
import { describe, it, expect } from "vitest";
import { getToolsForStage, getAllTools, AGENT_TOOLS, LSP_TOOLS } from "../services/agent-tools.js";

describe("Agent Tools", () => {
  describe("getAllTools", () => {
    it("returns all file and LSP tools", () => {
      const tools = getAllTools();
      expect(tools.length).toBe(AGENT_TOOLS.length + LSP_TOOLS.length);
    });

    it("all tools have required schema fields", () => {
      for (const tool of getAllTools()) {
        expect(tool.name).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema.type).toBe("object");
        expect(tool.inputSchema.properties).toBeDefined();
        expect(Array.isArray(tool.inputSchema.required)).toBe(true);
      }
    });

    it("tool names are unique", () => {
      const names = getAllTools().map((t) => t.name);
      expect(new Set(names).size).toBe(names.length);
    });
  });

  describe("getToolsForStage", () => {
    it("FORGE (index 5) gets all tools including write", () => {
      const tools = getToolsForStage(5);
      const names = tools.map((t) => t.name);
      expect(names).toContain("write_file");
      expect(names).toContain("edit_file");
      expect(names).toContain("shell_exec");
      expect(names).toContain("read_file");
      expect(names).toContain("lsp_hover");
    });

    it("EVOLVE (index 7) gets all tools including write", () => {
      const tools = getToolsForStage(7);
      const names = tools.map((t) => t.name);
      expect(names).toContain("write_file");
      expect(names).toContain("edit_file");
      expect(names).toContain("shell_exec");
    });

    it("SCAN (index 0) gets read-only tools — no write/edit/shell", () => {
      const tools = getToolsForStage(0);
      const names = tools.map((t) => t.name);
      expect(names).not.toContain("write_file");
      expect(names).not.toContain("edit_file");
      expect(names).not.toContain("shell_exec");
      // Should still have read tools
      expect(names).toContain("read_file");
      expect(names).toContain("search_code");
      expect(names).toContain("list_files");
    });

    it("analysis stages (1-4) are read-only", () => {
      for (const idx of [1, 2, 3, 4]) {
        const tools = getToolsForStage(idx);
        const names = tools.map((t) => t.name);
        expect(names).not.toContain("write_file");
        expect(names).not.toContain("edit_file");
        expect(names).not.toContain("shell_exec");
      }
    });

    it("all stages have LSP tools", () => {
      for (let i = 0; i < 8; i++) {
        const tools = getToolsForStage(i);
        const names = tools.map((t) => t.name);
        expect(names).toContain("lsp_hover");
        expect(names).toContain("lsp_definitions");
        expect(names).toContain("lsp_references");
        expect(names).toContain("lsp_document_symbols");
        expect(names).toContain("lsp_diagnostics");
      }
    });
  });
});
