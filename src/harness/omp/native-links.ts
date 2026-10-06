import type { ExtensionAPI, MessageRenderer } from "@oh-my-pi/pi-coding-agent";
import { z } from "zod";
import { type NativeReplyLink, nativeLinkLine } from "../../session/native-links.ts";

const TYPE = "tandem-native-links";
const linksSchema = z.array(
  z.object({
    label: z
      .string()
      .refine((value) =>
        [...value].every((char) => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127),
      ),
    url: z.string().regex(/^tandem:\/\/(task|brief|pr)\/[a-zA-Z0-9_-]+$/u),
  }),
);
export const renderNativeLinks: MessageRenderer = (message) => {
  const parsed = linksSchema.safeParse(message.details);
  if (!parsed.success) return undefined;
  return { render: () => [nativeLinkLine(parsed.data)], invalidate: () => {} };
};

export function registerNativeLinks(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(TYPE, renderNativeLinks);
}
export function showNativeLinks(pi: ExtensionAPI, links: readonly NativeReplyLink[]): void {
  if (links.length === 0) return;
  pi.sendMessage({
    customType: TYPE,
    content: links.map((l) => l.label).join(" · "),
    display: true,
    details: links,
    attribution: "agent",
  });
}
