declare module 'mermaid' {
  interface MermaidConfig {
    startOnLoad?: boolean;
    theme?: string;
    securityLevel?: string;
    fontFamily?: string;
    flowchart?: Record<string, any>;
    themeVariables?: Record<string, string>;
  }

  interface RenderResult {
    svg: string;
    bindFunctions?: (element: Element) => void;
  }

  const mermaid: {
    initialize: (config: MermaidConfig) => void;
    render: (id: string, definition: string) => Promise<RenderResult>;
  };

  export default mermaid;
}
