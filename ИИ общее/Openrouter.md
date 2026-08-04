api key : ВАШ_OPENROUTER_API_КЛЮЧ


fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer ВАШ_OPENROUTER_API_КЛЮЧ',
    'HTTP-Referer': '<YOUR_SITE_URL>',
    'X-Title': '<YOUR_SITE_NAME>',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'openai/gpt-4o',
    messages: [
      {
        role: 'user',
        content: 'What is the meaning of life?',
      },
    ],
  }),
});


```
curl https://openrouter.ai/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ВАШ_OPENROUTER_API_КЛЮЧ" \
  -d '{
  "model": "openai/gpt-4o",
  "messages": [
    {
      "role": "user",
      "content": "What is the meaning of life?"
    }
  ]
}'
```