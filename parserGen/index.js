//    Copyright 2018 Luis Hsu
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//
//        http://www.apache.org/licenses/LICENSE-2.0
//
//    Unless required by applicable law or agreed to in writing, software
//    distributed under the License is distributed on an "AS IS" BASIS,
//    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//    See the License for the specific language governing permissions and
//    limitations under the License.

const fs = require('fs');
const rule = require('./rule');
// Get start
var ruleStart = rule.start;
delete rule.start;
// Get terminals and expand opt element
var terms = {
	EOF:[]
};
Object.keys(rule).forEach((nonTerm) => {
	for(var i = 0; i < rule[nonTerm].length; ++i){
		var subrule = rule[nonTerm][i];
		subrule.forEach((elemStr, index) => {
			var elem = elemStr.replace("\t", "");
			if(elemStr.endsWith('\t')){
				var newSub = subrule.slice();
				newSub.splice(index, 1);
				rule[nonTerm].push(newSub);
				subrule[index] = elem;
			}
			// Terminal
			if(!rule[elem]){
				terms[elem] = [];
			}
		});
	}
});

// First set
var firstSet = JSON.parse(JSON.stringify(terms));
Object.keys(firstSet).forEach((key) => {
	firstSet[key].push(key);
});
for(var modified = true; modified; ){
	modified = false;
	Object.keys(rule).forEach((nonterm) => {
		rule[nonterm].forEach((subrule) => {
			if(firstSet[subrule[0]]){
				firstSet[subrule[0]].forEach((elem) => {
					if(!firstSet[nonterm]){
						firstSet[nonterm] = [elem];
						modified = true;
					}else if(!firstSet[nonterm].find((first) => {
						return first == elem;
					})){
						firstSet[nonterm].push(elem);
						modified = true;
					}
				});
			}
		});
	});
}

// LALR Automata
var states = [closure({
	items: [{
		nonterm: 'start',
		elements: [ruleStart],
		index: 0,
		lookahead: {
			EOF: "EOF"
		}
	}],
	gotos: {}
})];
function itemCompare(a, b, skipLookahead){
	if(!a || !b || a.nonterm != b.nonterm || a.index != b.index){
		return false;
	}
	if(a.elements.length != b.elements.length || a.lookahead.length != b.lookahead.length){
		return false;
	}
	for(var i = 0; i < a.elements.length; ++i){
		if(a.elements[i] != b.elements[i]){
			return false;
		}
	}
	if(!skipLookahead){
		var aLooks = Object.keys(a.lookahead);
		var bLooks = Object.keys(b.lookahead);
		for(var i = 0; i < aLooks.length; ++i){
			if(aLooks[i] != bLooks[i]){
				return false;
			}
		}
	}
	return true;
}
function closure(itemSet){
	for(var modified = true; modified; ){
		modified = false;
		for(var itemIndex = 0; itemIndex < itemSet.items.length; ++itemIndex){
			var item = itemSet.items[itemIndex];
			var key = item.elements[item.index];
			if(item.index < item.elements.length && rule[key]){
				var production = rule[key];
				var lookahead = {};
				if(item.index + 1 < item.elements.length){
					firstSet[item.elements[item.index + 1]].forEach((first) => {
						lookahead[first] = first;
					});
				}else{
					lookahead = Object.assign(lookahead, item.lookahead);
				}
				production.forEach((subrule) => {
					var newItem = {
						nonterm: key,
						elements: subrule,
						index: 0,
						lookahead: lookahead
					};
					var findItem = itemSet.items.find((f) => {
						return itemCompare(f, newItem);
					});
					if(!findItem){
						itemSet.items.push(newItem);
						modified = true;
					}
				});
			}
		}
	}
	return itemSet;
}
function gotoGet(item, symbol){
	// Search the same core item from states
	var newItem = Object.assign({}, item);
	newItem.index += 1;
	var itemIndex = -1;
	var gotoIndex = states.findIndex((state) => {
		for(var i = 0; i < state.items.length; ++i){
			if(state.items[i].index != 0 && itemCompare(state.items[i], newItem, true)){
				itemIndex = i;
				return true;
			}
		}
		return false;
	});
	if(gotoIndex != -1){
		// Found the same core
		states[gotoIndex].items[itemIndex].lookahead = Object.assign(states[gotoIndex].items[itemIndex].lookahead, item.lookahead);
		return {
			index: gotoIndex,
			modified: false
		};
	}else{
		// Create new state
		var newState = {
			items: [newItem],
			gotos: {}
		};
		return {
			index: states.push(closure(newState)) - 1,
			modified: true
		};
	}
}
for(var modified = true; modified; ){
	modified = false;
	for(var stateIndex = 0; stateIndex < states.length; ++stateIndex){
		var state = states[stateIndex];
		state.items.forEach((item) => {
			if(item.index < item.elements.length){
				var symbol = item.elements[item.index];
				var gotoResult = gotoGet(item, symbol);
				state.gotos[symbol] = gotoResult.index;
				modified = gotoResult.modified;
			}
		});
	}
}

// Generate parsing table module & reduce function module template

var reduceFuncs = {};
var tableOut = fs.createWriteStream('table.js');
tableOut.write("const reduceFuncs = require('./reduceFuncs');\n");
tableOut.write("module.exports = [\n");
states.forEach((state, index) => {
	if(index != 0){
		tableOut.write(",\n");
	}
	tableOut.write("\t{\n");
	var checkObj = {};
	var first = true;
	Object.keys(state.gotos).forEach((gotoKey) => {
		if(first){
			first = false;
		}else{
			tableOut.write(",\n");
		}
		tableOut.write(`\t\t"${gotoKey}": ${state.gotos[gotoKey]}`);
		if(checkObj[gotoKey]){
			console.log(`State ${index} has conflict with ${gotoKey} !`);
		}else{
			checkObj[gotoKey] = true;
		}
	});
	state.items.forEach((item) => {
		if(item.index >= item.elements.length){
			var funcName = `reduceFuncs.${item.nonterm}`;
			if(item.nonterm != "start"){
				var subIndex = rule[item.nonterm].findIndex((subrule) => {
					if(subrule.length != item.elements.length){
						return false;
					}
					for(var i = 0; i < subrule.length; ++i){
						if(subrule[i] != item.elements[i]){
							return false;
						}
					}
					return true;
				});
				funcName += `_${subIndex}`;
			}else{
				funcName += `_0`;
			}
			Object.keys(item.lookahead).forEach((lookKey) => {
				if(first){
					first = false;
				}else{
					tableOut.write(",\n");
				}
				tableOut.write(`\t\t"${lookKey}": ${funcName}`);
				reduceFuncs[funcName.replace("reduceFuncs.", "")] = null;
				if(checkObj[lookKey]){
					console.log(`State ${index} has conflict with ${lookKey} !`);
				}else{
					checkObj[lookKey] = true;
				}
			});
		}
	});
	tableOut.write("\n\t}");
});
tableOut.end("\n];\n");

var reduceOut = fs.createWriteStream('reduceFuncs.js');
reduceOut.write("module.exports = {\n");
var reduceKeyArray = Object.keys(reduceFuncs).sort((a, b) => {
	var aMatched = a.match(/_(\d+)$/);
	var bMatched = b.match(/_(\d+)$/);
	var cmp = a.replace(aMatched[0], "").localeCompare(b.replace(bMatched[0], ""));
	if(cmp == 0){
		return parseInt(aMatched[1]) - parseInt(bMatched[1]);
	}else{
		return cmp;
	}
});
for(var i = 0; i < reduceKeyArray.length; ++i){
	if(i != 0){
		reduceOut.write(",\n");
	}
	reduceOut.write(`\t"${reduceKeyArray[i]}": null`);
}
reduceOut.end("\n};\n");

// Output expanded rules
if(process.env.NO_RULE_JSON != "true"){
	fs.writeFile('rule.json', JSON.stringify(rule, null, '\t').replace(/\[\s+"/g, "[\"").replace(/,\n\t\t+"/g, ",\"").replace(/"\n\s*\]/g, "\"]"), () => {});
}

// Output states
if(process.env.STATE_JSON == "true"){
	fs.writeFile('states.json', JSON.stringify(states, null, '\t'), () => {});
}
if(process.env.STATE_GRAPHVIZ == "true"){

	function sanity(str){
		if(typeof str == "string"){
			return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/\'/g, "&#39;");
		}else{
			return str;
		}
	}

	var fout = fs.createWriteStream('states.dot');
	fout.write("digraph states {\n\tnode [shape=plaintext];\n\trankdir=\"LR\";\n\tgraph [splines=true];\n");
	states.forEach((state, index) => {
		fout.write(`\t/** State ${index} **/\n`);
		fout.write(`\tS${index} [label=<<TABLE BORDER="1" CELLBORDER="0">\n\t\t\t<TR><TD>S<SUB>${index}</SUB></TD></TR>\n`);
		state.items.forEach((item) => {
			fout.write(`\t\t\t<TR><TD ALIGN="LEFT">${sanity(item.nonterm)} &rarr;`);
			item.elements.forEach((elem, id) =>{
				if(id == item.index){
					fout.write(" &oplus;");
				}
				fout.write(` ${sanity(elem)}`);
			});
			if(item.index == item.elements.length){
				fout.write(" &oplus;");
			}
			fout.write(" | ");
			var lookahead = Object.keys(item.lookahead);
			lookahead.forEach((look, id) => {
				fout.write("\'"+look+"\'");
				if(id != lookahead.length - 1){
					fout.write(" / ");
				}
			});
			fout.write("</TD></TR>\n");
		});
		fout.write("\t\t</TABLE>>]\n");
		var gotos = Object.keys(state.gotos);
		gotos.forEach((key) => {
			fout.write(`\tS${index} -> S${state.gotos[key]} [label="${sanity(key)}"]\n`);
		});
	});
	fout.end("}");
}