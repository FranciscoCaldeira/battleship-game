var express = require('express');
var app = express();
var http = require('http').Server(app);
var io = require('socket.io')(http);
//var bodyParser = require('body-parser');

//url encode e decode
var Entities = require('html-entities').AllHtmlEntities;
var entities = new Entities();

//embebd js
var ejs      = require('ejs');
app.set('view engine','ejs');
app.set('views',__dirname+'/views');

//load da página inicial
app.get('/',function(req,res){
  res.render('index', {
    canvas_msg_error: 'Browser does not support canvas.'
  });
});

//extra rank
app.get('/rank',function(req,res){
  con.query("SELECT `socket_id`, SUM(`score`) as score_sum   FROM rank   GROUP BY `socket_id`   ORDER BY score_sum DESC", function (err, result, fields) {
    if (err) throw err;
    console.log(result);
    res.render('rank', { values: result });
  });
});

//bd
const mysql = require('mysql');
const con = mysql.createConnection({
  host: "localhost",
  user: "root",
  password: "",
  database: "battle"
});
//ligação à bd
con.connect(function(err) {
    console.log("Ligação com uma DB! Usa os seguintes sql no MYSQL:");
    console.log("CREATE DATABASE battle");
    console.log("CREATE TABLE `user` (`id` int(11) NOT NULL,`socket_id` varchar(255) NOT NULL,`name` varchar(50) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=latin1;ALTER TABLE `user`ADD PRIMARY KEY (`id`),ADD UNIQUE KEY `socket_id` (`socket_id`), MODIFY `id` int(11) NOT NULL AUTO_INCREMENT,ADD `created_at` TIMESTAMP NOT NULL AFTER `name`;");
    console.log("CREATE TABLE `rank` (`id` int(11) NOT NULL,`socket_id` varchar(255) NOT NULL,`score` int(11) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=latin1;ALTER TABLE `rank` ADD PRIMARY KEY (`id`); ALTER TABLE `rank` MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;")
    console.log("CREATE TABLE `game` (`id` int(11) NOT NULL,`game` int(11) NOT NULL,`socket_id_1` varchar(255) NOT NULL,`socket_id_2` varchar(255) NOT NULL,`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)});ALTER TABLE `game` ADD PRIMARY KEY (`id`);ALTER TABLE `game` MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;")
    console.log("***********************************************************************************************")
});

var BattleshipGame = require('./app/game.js');
var GameStatus = require('./app/gameStatus.js');

var users = {};
var gameIdCounter = 1; //nr dos rooms

app.use(express.static(__dirname + '/views/')); // diretório das views

var port = 8000;
http.listen(port, function(){
  console.log('Ligue a 127.0.0.1:' + port);
});


io.on('connection', function(socket) {
    console.log('Alguém com o ID ' + socket.id + ' entrou no lobby.');
    /** regista este na db*/
    var newUser = {socket_id: socket.id,
                   created_at: new Date()}
    con.query(
        'INSERT INTO user SET ?', newUser, (err, res) => {
        if (err) throw err
        console.log(`New user`);
    })

  // create user object for additional data
  users[socket.id] = {
    inGame: null, //users[socket.id]["inGame"]
    player: null
  }; 

  // join waiting room until there are enough players to start a new game
  socket.join('waiting room'); //socketio rooms/channel são feitos com o join
    /**
    * Dá um nome ao socket.id, quando está esperando
    */
    socket.on('set_user', function(data) {
      var socket_id = socket.id;
      var name = entities.encode(data);

      var sql = "UPDATE user SET name = '"+name+"' WHERE socket_id = '"+socket_id+"'";

      con.query(sql, function (err, result) {
        if (err) throw err;
      });

    });

  /**
   * Handle chat messages
   */
  socket.on('chat', function(msg) {
    if(users[socket.id].inGame !== null && msg) { 
      // Send message to opponent
      socket.broadcast.to('game' + users[socket.id].inGame.id).emit('chat', {
        name: 'Oponente', //aqui é meter o name caso ele tenha
        message: entities.encode(msg),
      });

      // Send message to self
      io.to(socket.id).emit('chat', {
        name: 'Eu',
        message: entities.encode(msg),
      });
    }
  });

  /**
   * Handle shot from client
   */
  socket.on('shot', function(position) {
    var game = users[socket.id].inGame, opponent;

    if(game !== null) {
      // Is it this users turn?
      if(game.currentPlayer === users[socket.id].player) {
        opponent = game.currentPlayer === 0 ? 1 : 0;

        if(game.shoot(position)) {
          // Valid shot
          checkGameOver(game);

          // Update game state on both clients.
          io.to(socket.id).emit('update', game.getGameState(users[socket.id].player, opponent));
          io.to(game.getPlayerId(opponent)).emit('update', game.getGameState(opponent, opponent));
        }
      }
    }
  });
  
  /**
   * Handle leave game request
   */
  socket.on('leave', function() {
    if(users[socket.id].inGame !== null) {
      leaveGame(socket);

      socket.join('waiting room');
      joinWaitingPlayers();
    }
  });

  /**
   * Handle client disconnect
   */
  socket.on('disconnect', function() {
    leaveGame(socket);

    delete users[socket.id];
  });

  joinWaitingPlayers();
});


/**
 * Create games for players in waiting room
 */
function joinWaitingPlayers() {
  var players = getClientsInRoom('waiting room');
  
  if(players.length >= 2) {
    // 2 player waiting. Create new game!
    var game = new BattleshipGame(gameIdCounter++, players[0].id, players[1].id); //gamecounter é o nr do rooms player id vem o socket id
    
    var newGame = { game: game.id,
                    socket_id_1: players[0].id,
                    socket_id_2: players[1].id,
                    created_at: new Date()};
    con.query(
      'INSERT INTO game SET ?', newGame, (err, res) => {
      if (err) throw err
      console.log(`New Game`);
    });                

    // create new room for this game
    players[0].leave('waiting room');
    players[1].leave('waiting room');
    players[0].join('game' + game.id);
    players[1].join('game' + game.id);

    users[players[0].id].player = 0;
    users[players[1].id].player = 1;
    users[players[0].id].inGame = game;
    users[players[1].id].inGame = game;
    
    io.to('game' + game.id).emit('join', game.id);

    // send initial ship placements
    io.to(players[0].id).emit('update', game.getGameState(0, 0));
    io.to(players[1].id).emit('update', game.getGameState(1, 1));
  }
}

/**
 * Leave user's game
 * @param {type} socket
 */
function leaveGame(socket) {
  if(users[socket.id].inGame !== null) {

    // Notifty opponent
    socket.broadcast.to('game' + users[socket.id].inGame.id).emit('notification', {
      message: 'O seu oponente saiu do jogo.'
    });

    if(users[socket.id].inGame.gameStatus !== GameStatus.gameOver) {
      // Game is unfinished, abort it.
      users[socket.id].inGame.abortGame(users[socket.id].player);
      checkGameOver(users[socket.id].inGame);
    }

    socket.leave('game' + users[socket.id].inGame.id);

    users[socket.id].inGame = null;
    users[socket.id].player = null;

    io.to(socket.id).emit('leave');
  }
}

/**
 * Notify players if game over.
 * @param {type} game
 */
function checkGameOver(game) {
  if(game.gameStatus === GameStatus.gameOver) {
    io.to(game.getWinnerId()).emit('gameover', true);

    var winner = {socket_id: game.getWinnerId(),
                  score: 1}
    con.query(
      'INSERT INTO rank SET ?', winner, (err, res) => {
      if (err) throw err
    })

    io.to(game.getLoserId()).emit('gameover', false);

    var loser = {socket_id: game.getLoserId(),
                 score: -1}
    con.query(
      'INSERT INTO rank SET ?', loser, (err, res) => {
      if (err) throw err
    })

    console.log( ' ID ' + game.getWinnerId() + ' ganhou ');
    console.log( ' ID ' + game.getLoserId() + ' perdeu ');

  }
}

/**
 * Find all sockets in a room
 * @param {type} room
 * @returns {Array}
 */
function getClientsInRoom(room) {
  var clients = [];
  for (var id in io.sockets.adapter.rooms[room]) {
    clients.push(io.sockets.adapter.nsp.connected[id]);
  }
  return clients;
}
