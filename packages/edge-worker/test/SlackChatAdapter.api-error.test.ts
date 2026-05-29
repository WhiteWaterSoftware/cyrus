import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture postMessage calls by mocking the Slack transport service.
const postMessageMock = vi.fn().mockResolvedValue(undefined);

vi.mock("cyrus-slack-event-transport", async (importActual) => {
	const actual = await importActual<any>();
	return {
		...actual,
		SlackMessageService: class {
			postMessage = postMessageMock;
			getIdentity = vi.fn().mockResolvedValue({ bot_id: "B123" });
		},
		SlackReactionService: class {
			addReaction = vi.fn().mockResolvedValue(undefined);
			removeReaction = vi.fn().mockResolvedValue(undefined);
		},
	};
});

import { SlackChatAdapter } from "../src/SlackChatAdapter";

// A runner whose constructor name is not a known non-Claude runner, so it
// resolves to the "claude" display name.
class FakeClaudeRunner {
	private messages: any[];
	constructor(messages: any[]) {
		this.messages = messages;
	}
	getMessages() {
		return this.messages;
	}
}

const assistantTextMessage = (text: string) => ({
	type: "assistant",
	message: { content: [{ type: "text", text }] },
});

const makeEvent = () =>
	({
		slackBotToken: "xoxb-test",
		payload: {
			channel: "C123",
			ts: "1700000000.000100",
			thread_ts: "1700000000.000001",
			text: "hi",
		},
	}) as any;

describe("SlackChatAdapter API error attribution", () => {
	let adapter: SlackChatAdapter;

	beforeEach(() => {
		postMessageMock.mockClear();
		const repositoryProvider = {
			getRepositories: vi.fn().mockReturnValue([]),
		} as any;
		adapter = new SlackChatAdapter(repositoryProvider);
	});

	it("relabels a Claude API error as a provider error with recovery guidance", async () => {
		const runner = new FakeClaudeRunner([
			assistantTextMessage(
				"API Error: 400 messages.1.content.3: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.",
			),
		]) as any;

		await adapter.postReply(makeEvent(), runner);

		expect(postMessageMock).toHaveBeenCalledTimes(1);
		const posted = postMessageMock.mock.calls[0][0];
		expect(posted.text).toContain("**Claude API error**");
		expect(posted.text).toContain("not from Cyrus");
		expect(posted.text).toContain(
			"start a new thread to reset the conversation",
		);
		expect(posted.text).toContain("`thinking` or `redacted_thinking` blocks");
	});

	it("posts a normal assistant reply unchanged", async () => {
		const runner = new FakeClaudeRunner([
			assistantTextMessage("Here's what I found in your Slack history."),
		]) as any;

		await adapter.postReply(makeEvent(), runner);

		expect(postMessageMock).toHaveBeenCalledTimes(1);
		const posted = postMessageMock.mock.calls[0][0];
		expect(posted.text).toBe("Here's what I found in your Slack history.");
	});
});
