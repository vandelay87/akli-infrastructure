import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const path = event.rawPath || '/'

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
    },
    body: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>akli.dev - SSR Placeholder</title>
</head>
<body>
  <h1>akli.dev</h1>
  <p>SSR placeholder for path: ${path}</p>
  <p>This page will be replaced by the server-rendered React app.</p>
</body>
</html>`,
  }
}
