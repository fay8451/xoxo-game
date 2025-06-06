# SSL Certificates for WSS (WebSocket Secure)

Place your SSL certificates in this directory to enable secure WebSocket connections (WSS).

You need two files:
1. `privkey.pem` - Your private key
2. `cert.pem` - Your SSL certificate

## How to get SSL certificates

### For Production
For a production environment, you should obtain a proper SSL certificate from a Certificate Authority (CA) like Let's Encrypt, Comodo, DigiCert, etc.

### For Development/Testing
For development or testing, you can generate a self-signed certificate:

\`\`\`bash
openssl req -x509 -newkey rsa:4096 -keyout privkey.pem -out cert.pem -days 365 -nodes
\`\`\`

Note: Browsers will show a security warning when using self-signed certificates.

## Security Notice
- Keep your private key secure and never commit it to public repositories
- For production, use proper certificates from trusted Certificate Authorities
- Regularly update your certificates before they expire
