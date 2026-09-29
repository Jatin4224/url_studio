export const validateWebsiteUrl = (input: any) => {
  if (typeof input !== "string" || !input.trim()) {
    return { error: "Enter a website URL." };
  }
  const value = input.trim();

  if (!/^https?:\/\//i.test(value)) {
    return { error: "Start the URL with https:// or http://." };
  }

  try {
    const url = new URL(value);
    if (url.username || url.password) {
      return { error: "Use a URL without a username or password." };
    }
    return { url: url.href };
  } catch (error) {
    return { error: "Enter a valid website URL." };
  }
};
