export async function handler() {
  try {
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          ok: false,
          error: "OPENAI_API_KEY missing in Netlify environment variables"
        })
      };
    }

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        input: "Reply with exactly: FitApp AI connected"
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        statusCode: response.status,
        body: JSON.stringify({
          ok: false,
          error: data
        })
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        message: data.output_text || data
      })
    };

  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        ok: false,
        error: error.message
      })
    };
  }
}
