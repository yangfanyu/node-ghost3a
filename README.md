# node-ghost3a
 
  Lightweight, web server, websocket server, websocket client. Cluster support. Simple and easy to use.

  https://github.com/yangfanyu/node-ghost3a
  
# Install 
 
  PM2 management process is recommended:
   
  `npm install pm2 -g`
   
  Then install this framework in your project directory:
  
  `npm install node-ghost3a`
  
# Server and client example

  ```
  git clone https://github.com/yangfanyu/node-ghost3a.git
  
  cd node-ghost3a/example
  
  pm2 start ecosystem.config.js --env development
  ```
  
  Then browse `http://localhost:8080/` in your **modern browser**.
  
  You can use `pm2 log` to see the server logs.
  

# Client for flutter or dart
  
  Edit dependencies in _pubspec.yaml_
  ```
     dependencies:
       wssnet_ghost3a: ^3.1.29
  ```  
  
  API usage is the same as index.html in example.
  
# API document

  See the source code comments in src for the framework. My notes are very detailed.




