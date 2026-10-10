import { createBashToolDefinition, type ToolRendererResolver } from "@earendil-works/pi-coding-agent";

export function captureBashRenderer(tools: Map<string, any>, bashTool = createBashToolDefinition(process.cwd())) {
	return (resolver: ToolRendererResolver): void => {
		const renderers = resolver("bash", () => bashTool);
		if (renderers) tools.set("bash", { ...bashTool, ...renderers });
	};
}
