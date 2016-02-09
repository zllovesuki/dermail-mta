var stream = require('stream');

module.exports = {
	bufferToStream: function(data) {
		var fileStream = new stream.PassThrough();
		fileStream.end(new Buffer(data));
		return fileStream;
	}
}
