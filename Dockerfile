FROM node:18 AS builder
WORKDIR /app

# copiar primero package.json Y scripts
COPY package*.json ./
COPY scripts ./scripts

RUN npm install

COPY . .
RUN npm run build


# Paso 2: Servir el build estático con Nginx
FROM nginx:alpine
COPY --from=builder /app/build /usr/share/nginx/html

# Expone el puerto
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
