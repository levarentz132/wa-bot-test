FROM node:20-alpine

# Install git and python (required for some native dependencies)
RUN apk add --no-cache git python3 make g++

WORKDIR /app

COPY package.json ./

RUN npm install

COPY . .

EXPOSE 3001

CMD ["npm", "run", "dev"]
