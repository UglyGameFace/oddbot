# Use the official Node.js 20 image on Alpine Linux for a small, secure base
FROM node:20-alpine

# Set the working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json to leverage Docker's layer caching.
# This step only re-runs if these files change.
COPY package*.json ./

# Install production dependencies
RUN npm install --omit=dev

# Copy the rest of your application code into the container
COPY . .

# Expose the port your web service will run on. This matches the PORT
# environment variable in your 'parlay-bot' service.
EXPOSE 8080

# The CMD is not strictly necessary as Railway uses the 'startCommand'
# from your railway.json, but it's good practice for local testing.
CMD [ "npm", "start" ]
 
