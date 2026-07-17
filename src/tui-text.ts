import { Text } from "@earendil-works/pi-tui";

type TextCtor = new (
	text?: string,
	paddingX?: number,
	paddingY?: number,
) => {
	setText(value: string): void;
};

export function getTextCtor(): TextCtor {
	return Text;
}

export function resolveTextCtor(TextComp?: TextCtor): TextCtor {
	return TextComp ?? Text;
}
