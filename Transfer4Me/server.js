var express = require('express');
var uuid = require('node-uuid');
var bodyParser = require('body-parser');
var cookieParser = require('cookie-parser');
var winston = require('winston');
var fs = require('fs');

var app = express();
var io;

// if production parameter exists, use HTTPS
// else use HTTP
var production = process.argv.indexOf("-p");
if (production !== -1) {
    var https = require('https').createServer({
            key: fs.readFileSync('certificate/transfer4me.key'),
            cert: fs.readFileSync('certificate/www_transfer4_me.crt'),
            ca: [fs.readFileSync('certificate/www_transfer4_me.ca-bundle')]}
        , app);
    https.listen(443, function () {
        console.log('listening on *:443');
    });
    var http = require('http').createServer(function (req, res) {
        res.writeHead(301, { "Location": "https://" + req.headers['host'] + req.url });
        res.end();
    }).listen(80);
    io = require('socket.io')(https);
} else {
    var http = require('http').Server(app);
    http.listen(80, function () {
        console.log('listening on *:80');
    });
    io = require('socket.io')(http);
}

app.use(express.static(__dirname + '/public/'));
app.use(bodyParser.urlencoded({extended: false}));
app.use(bodyParser.json());
app.use(cookieParser());

var baseUrl = "/room/";
var rooms = [];

var date = new Date();
var dateString = "-" + date.getUTCDate() + "-" + date.getUTCMonth() + "-" + date.getUTCFullYear();
var logger = new (winston.Logger)({
    transports: [
        new (winston.transports.File)({ filename: './logs/stats/p2p_data' + dateString + ".log" })
    ]
});

//Room represents a space in which a uploader has uploaded a file.
function Room(id, password) {
    this.namespace = io.of(baseUrl.concat(id));
    this.id = id;
    if (password) {
        this.password = password;
    }

    this.uploader = null;
    this.users = 0;

    this.fileType;
    this.fileSize;

    var room = this;

    this.namespace.on('connection', function (socket) {
        //if a room uploader doesn't exist, make the first socket to connect the uploader.
        //else add a user and alert the uploader.
        if (!room.uploader) {
            room.uploader = socket.client.id;
        } else {
            room.users++;
            room.namespace.to(room.namespace.name.concat("#", room.uploader)).emit('signal', JSON.stringify({
                'user': "SERVER",
                'toUser': room.uploader,
                "users": room.users
            }));
        }

        console.log(socket.client.id + " connected to room: " + room.id);

        socket.on('disconnect', function () {
            console.log(socket.client.id + " disconnected from room: " + room.id);
            //if the uploader leaves, remove the room from the list.
            //else just remove the user from the room and alert the uploader.
            if (this.client.id == room.uploader) {
                for (var i = 0; i < rooms.length; i++) {
                    if (rooms[i].uploader == this.client.id) {
                        rooms.splice(i, 1);
                        break;
                    }
                }
            } else {
                room.users--;
                room.namespace.to(room.namespace.name.concat("#", room.uploader)).emit('signal', JSON.stringify({
                    'user': "SERVER",
                    'toUser': room.uploader,
                    "users": room.users
                }));
            }
        });

        socket.on('signal', function (signal) {
            var parsedSignal = JSON.parse(signal);
            console.log(signal);
            //if the signal contains a specific socket, send it to them
            //else just send the signal to the uploader.
            if (parsedSignal.toUser) {
                room.namespace.to(room.namespace.name.concat("#", parsedSignal.toUser.userId)).emit('signal', signal);
            } else {
                room.namespace.to(room.namespace.name.concat("#", room.uploader)).emit('signal', signal);
            }
        });

        //Uploader sends metadata in when the file is uploaded.
        socket.on('metadata', function (result) {
            if (room.fileType == null) {
                room.fileType = JSON.parse(result).fileType;
            }
            if (room.fileSize == null) {
                room.fileSize = JSON.parse(result).fileSize;
            }
        });

        //When recipient starts to download or stream, they gather statistics and send them in.
        socket.on('stats', function (stats) {
            stats = JSON.parse(stats);
            stats.roomId = room.id;
            stats.fileType = room.fileType;
            stats.fileSize = room.fileSize;
            logger.info(stats);
            //if streaming, send streaming statistics to uploader,
            //else if downloading, send downloading statistics to them.
            if (stats.stats.audioChannel && stats.toUserId) {
                room.namespace.to(room.namespace.name.concat("#",stats.toUserId)).emit('signal', JSON.stringify({
                    userId: stats.userId,
                    stats: {
                        streamBytesReceived: stats.stats.audioChannel.bytesReceivedPerSecond,
                    }
                }));
            } else if (stats.stats.dataChannel && stats.toUserId) {
                room.namespace.to(room.namespace.name.concat("#", stats.toUserId)).emit('signal', JSON.stringify({
                    userId: stats.userId,
                    stats: {
                        downloadBytesReceived: stats.stats.dataChannel.bytesReceivedPerSecond
                    }
                }));
            }
        });

    });
}

app.get('/', function (req, res) {
    res.sendFile("public/index.html", {"root": __dirname});
});

//Add a room
//Accepts optional password field in request body
//Returns ID and optional password with 201 Created status
app.post('/room', function (req, res) {
    var roomId = uuid.v1();
    var password;
    if (req.body.passworded) {
        password = require('just.randomstring')();
    }

    rooms.push(new Room(roomId, password));

    var result = new Object();
    result.roomId = roomId;
    result.password = password;
    res.status(201);
    res.json(JSON.stringify(result));
});

//Get a room
//If a password cookie has been added with the request or the room doesn't have a password, serve the index page
//Else serve the password page
//If a room isn't found, redirect them to the home page.
app.get('/room/:room', function (req, res) {
    var roomFound = false;
    findRoom(req.params.room, function (room) {
        roomFound = true;
        if (room.password == null || room.password == req.cookies.password) {
            res.sendFile("public/index.html", {"root": __dirname});
        } else if (room.password !== null) {
            res.sendFile("public/password.html", {"root": __dirname});
        }
    });
    if (!roomFound) {
        res.redirect("/");
    }
});

//Get the file type associated with the file uploaded in the room.
app.get('/room/:room/fileType', function (req, res) {
    findRoom(req.params.room, function (room) {
        if(room.fileType != null) {
            res.status(200);
            res.json(JSON.stringify({"fileType" : room.fileType}));
        }
    });
});

//Validate the password
//Requires a password field in request body
//If password is successful, adds a cookie to the response and returns 200 OK
//Else returns 401 Unauthorized
app.post('/room/:room/password', function (req, res) {
    findRoom(req.params.room, function (room) {
        var password = req.body.password;
        if (room.password == password) {
            res.cookie("password", password);
            var result = new Object();
            result.accepted = true;
            result.roomId = room.id;
            res.status(200);
            res.json(JSON.stringify(result));
        } else {
            res.sendStatus(401);
        }
    });
});

function findRoom(roomId, foundCallback) {
    for (var i = 0; i < rooms.length; i++) {
        if (rooms[i] !== null && rooms[i] !== undefined && rooms[i].id == roomId) {
            foundCallback(rooms[i]);
            return;
        }
    }
}






