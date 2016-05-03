var htmlToText = require('html-to-text');

module.exports = {
	convertHtmlToText: function (html) {
		return htmlToText.fromString(html);
	},
	convertTextToHtml: function (text) {
	    /* Replace newlines by <br>. */
	    text = text.replace(/(\n\r)|(\n)/g, '<br>');
	    /* Remove <br> at the begining. */
	    text = text.replace(/^\s*(<br>)*\s*/, '');
	    /* Remove <br> at the end. */
	    text = text.replace(/\s*(<br>)*\s*$/, '');
	    return text;
	}

}
