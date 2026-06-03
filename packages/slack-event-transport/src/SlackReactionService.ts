/**
 * Service for adding and removing reactions on Slack messages.
 *
 * Uses the Slack Web API with a bot token to manage emoji reactions,
 * typically used to acknowledge receipt of @mention webhooks and to
 * signal that a message has been processed.
 */

/**
 * Parameters for adding or removing a reaction on a Slack message
 */
export interface SlackReactionParams {
	/** Slack Bot OAuth token */
	token: string;
	/** Channel ID where the message is */
	channel: string;
	/** Timestamp of the message to react to */
	timestamp: string;
	/** Emoji name (without colons), e.g. "eyes" */
	name: string;
}

export class SlackReactionService {
	private apiBaseUrl: string;

	constructor(apiBaseUrl?: string) {
		this.apiBaseUrl = apiBaseUrl ?? "https://slack.com/api";
	}

	/**
	 * Add a reaction to a Slack message.
	 *
	 * @see https://api.slack.com/methods/reactions.add
	 */
	async addReaction(params: SlackReactionParams): Promise<void> {
		// "already_reacted" is not an error worth surfacing
		await this.callReactionApi("reactions.add", params, "already_reacted");
	}

	/**
	 * Remove a reaction from a Slack message.
	 *
	 * @see https://api.slack.com/methods/reactions.remove
	 */
	async removeReaction(params: SlackReactionParams): Promise<void> {
		// "no_reaction" means it was never added (or already removed) — fine
		await this.callReactionApi("reactions.remove", params, "no_reaction");
	}

	private async callReactionApi(
		method: "reactions.add" | "reactions.remove",
		params: SlackReactionParams,
		ignorableError: string,
	): Promise<void> {
		const { token, channel, timestamp, name } = params;

		const url = `${this.apiBaseUrl}/${method}`;

		const response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ channel, timestamp, name }),
		});

		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(
				`[SlackReactionService] ${method} failed: ${response.status} ${response.statusText} - ${errorBody}`,
			);
		}

		// Slack API returns HTTP 200 even for errors — check the response body
		const responseBody = (await response.json()) as {
			ok: boolean;
			error?: string;
		};
		if (!responseBody.ok && responseBody.error !== ignorableError) {
			throw new Error(
				`[SlackReactionService] Slack API error: ${responseBody.error ?? "unknown"}`,
			);
		}
	}
}
