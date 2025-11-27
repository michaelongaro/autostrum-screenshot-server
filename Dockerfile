FROM node:20-bookworm

WORKDIR /app

# Copy package files first (better caching)
COPY package*.json ./

# Install dependencies
RUN npm install

# Install Playwright Chromium with system dependencies
RUN npx playwright install chromium --with-deps

# Copy the rest of your code
COPY . .

# Build your TypeScript
RUN npm run build

# Expose your server port
EXPOSE 8080

# Start the server
CMD ["npm", "start"]