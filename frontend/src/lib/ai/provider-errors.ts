/**
 * Provider errors reach the UI as raw API text ("404: {"message":"The model …
 * does not exist or you do not have access to it."}"), which tells the user
 * nothing about what to do. The common ones get a sentence that does; anything
 * unrecognised is passed through unchanged rather than hidden.
 */
export const explainProviderError = (message: string): string => {
  if (/model_not_found|does not exist or you do not have access/i.test(message)) {
    return "This model is not available for your account. Pick another model in the dashboard (Dashboard → your provider).";
  }
  if (/\b401\b|\b403\b|invalid_api_key|unauthorized|api key not valid/i.test(message)) {
    return "The provider rejected the login. Check the API key or log in again in the dashboard.";
  }
  if (/\b429\b|rate.?limit|quota/i.test(message)) {
    return "The provider is rate limiting requests right now. Wait a moment and try again.";
  }
  if (/\b50[0-4]\b|overloaded|upstream/i.test(message)) {
    return "The provider is having trouble right now. Try again in a moment.";
  }
  if (/fetch|network|connection refused|dns/i.test(message)) {
    return "Could not reach the provider. Check your internet connection.";
  }
  return message;
};
