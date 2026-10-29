// What a visitor sees when this server has no API keys. That is the normal state of the hosted demo,
// where only the pre-generated samples work, so the messages say what to do instead of what is missing.
const HOW = 'Use the sample photo and pieces, or run Second Look locally with your own keys (see the README).';

export const NO_CLAUDE_KEY = `Live tagging and advice need ANTHROPIC_API_KEY, which is not set on this server. ${HOW}`;
export const NO_YOUCAM_KEY = `Live try-ons need YOUCAM_API_KEY, which is not set on this server. ${HOW}`;
