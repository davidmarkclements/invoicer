#!/usr/bin/env node

var fs = require('fs');
var path = require('path');
var mkdirp = require('mkdirp');
var split = require('split');
var through2 = require('through2');
var concat = require('concat-stream');
var sprintf = require('sprintf');
var spawn = require('child_process').spawn;
var strftime = require('strftime');
var os = require('os');
var table = require('text-table');

var argv = require('minimist')(process.argv.slice(2), {
    alias: {
        r: 'rcpt',
        e: 'expense',
        v: 'verbose',
        i: 'interactive',
        m: 'mode',
        o: 'output',
        t: 'template',
        t: 'tax'
    }
});
var outfile = argv.o;
var mode = argv.mode || /\.pdf$/.test(outfile) || 'text';

if (mode === 'pdf' && !argv.rcpt) return usage(1)
if (argv.h || argv.help) return usage(0);

var template = argv.template || path.join(__dirname, '..', 'invoice.tex');
var texsrc = fs.readFileSync(template, 'utf8');

var configDir = argv.c || path.join(
    process.env.HOME || process.env.USERDIR, '.config', 'invoicer'
);
mkdirp.sync(configDir);

var configFile = argv.c || path.join(configDir, 'config.json');
if (!fs.existsSync(configFile)) {
    if (!process.stdin.isTTY && !argv.i) {
        console.error('configuration file not found');
        return process.exit(1);
    }
    return prompter(function (err, cfg) {
        if (err) return console.error(err);
        writeConfig(cfg);
        readJSON(cfg);
    });
}
else readJSON(require(configFile));

function readJSON (cfg) {
    if (argv.e) {
        var expenses = require(path.resolve(argv.e));
        return withConfig(require(configFile), expenses);
    }
    
    process.stdin.pipe(concat(function (body) {
        var expenses = JSON.parse(body);
        withConfig(require(configFile), expenses);
    }));
}

function withConfig (cfg, expenses) {
    if (cfg.id === undefined) cfg.id = 1;
    if (mode === 'text') {
        var hours = expenses[0].hours.map(function (row) {
            return [ row.date, row.hours ];
        });
        var total = expenses[0].hours.reduce(function (sum, row) {
            return sum + row.hours;
        }, 0);
        var totals = [
            [ '-----------', '-----' ],
            [ 'total hours', round(total, 100) ],
            [ 'hourly rate', expenses[0].rate ],
            [ 'total', round(total * expenses[0].rate, 100) ]
        ];
        console.log(table(
            [
                [ 'date', 'hours' ],
                [ '----', '-----' ]
            ].concat(hours).concat(totals),
            { align: [ 'l', 'l', 'l' ] }
        ));
        return;
    }
    
    var params = {
        id: sprintf('%08d', cfg.id ++),
        name: cfg.name,
        address: cfg.address.replace(/\n/g, ' \\\\\n'),
        payterms: cfg.payterms.replace(/\n/g, ' \\\\\n'),
        compNo: cfg.compNo,
        vatNo: cfg.vatNo,
        footer: cfg.footer.replace(/\n/g, ' \\\\\n'),
        email: cfg.email,
        rcpt: argv.rcpt,
        expenses: expenses.reduce(function (acc, row) {
            if (row.subtitle) { 
                row.title += '\n\\newline\n' + row.subtitle + '\n\\vspace{.5em}\n'; 
            }

            if (row.rate && row.hours) {
                var title = row.title || 'consulting';
                acc.push('{\\bf ' + title + '} & ');
                row.hours.forEach(function (r) {
                    acc.push(
                        strftime('%F', new Date(r.date))
                        + ' & ' + r.hours + 'h * ' + row.rate
                    );
                });
            }
            if (row.items) {
                var title = row.title || 'expenses';

                acc.push('{\\bf ' + title + '} & ');
                acc.push.apply(acc, row.items.map(function (r) {
                    return r.title + ' & ' + r.amount;
                }));
            }
            if (row.amount) {
                var amount = row.amount;
                if (cfg.cursym) {
                  amount = cfg.cursym + amount;
                }
                acc.push('{\\bf ' + row.title + '} &  & ' + amount);
            }
            return acc;
            
        }, []).join(' \\\\\n') + ' \\\\\n',
        totals: (function () {
            var hours = 0;
            expenses.forEach(function (row) {
                (row.hours || []).forEach(function (r) {
                    hours += r.hours;
                });
            });
            hours = round(hours, 100);
            
            var rates = Object.keys(expenses.reduce(function (acc, row) {
                if (row.rate) acc[row.rate] = true;
                return acc;
            }, {}));
            
            var amount = round(expenses.reduce(function (acc, row) {
                if (row.hours) {
                    acc += row.rate * row.hours.reduce(function (h, r) {
                        return h + r.hours;
                    }, 0)
                }
                if (row.items) {
                    row.items.forEach(function (r) {
                        acc += r.amount || 0;
                    });
                }
                if (row.amount) {
                    acc += row.amount;
                }
                return acc;
            }, 0), 100) 


            var vat = cfg.vat || argv.t;
            vat = (typeof vat !== 'undefined') ? vat : 'N/A';
            vat = (typeof vat !== 'string' || vat === 'N/A') ? vat : parseFloat(vat);
            if (vat !== 'N/A') {
              vat = vat < 1 ? vat : vat / 100;
              vat = round(amount * vat, 100);
              amount += vat;  
            }

            if (cfg.cursym) {
              amount = cfg.cursym + amount;
              vat = vat === 'N/A' ? vat : cfg.cursym + vat;
              rates = rates.map(function(rate) { return cfg.cursym + rate; })
            } 
            
              
            
            return [
                hours && ('{\\bf Total Hours} &  & {\\bf ' + hours + '}'),
                hours && ('{\\bf Hourly Rate} &  & {\\bf '
                    + rates.join(',') + ' ' + cfg.currency + '}'),
                '\\',
                ' & {\\bf VAT} & {\\bf ' + vat + '}',
                ' & {\\bf Total (' + cfg.currency + ')} & {\\bf ' + amount + '}',
                '\\hline'
            ].filter(Boolean).join(' \\\\\n') + ' \\\\\n';
        })()
    };
    
    var output = texsrc.replace(
        /(?!\\)\${([^}]+)}/g,
        function (_, key) { return params[key] }
    );
    
    var tmpdir = path.join(os.tmpdir(), 'invoicer-' + Math.random());
    mkdirp.sync(tmpdir);
    
    if (/\.tex$/.test(outfile)) {
        return fs.writeFileSync(outfile, output);
    }
    
    fs.writeFileSync(path.join(tmpdir, 'invoice.tex'), output);
    
    var args = [ '-interaction', 'nonstopmode', '-halt-on-error', 'invoice.tex' ];
    var ps = spawn('pdflatex', args, { cwd: tmpdir });
    
    var stderr = '';
    ps.stdout.on('data', function (buf) { stderr += buf });
    
    if (argv.v) {
        ps.stdout.pipe(process.stdout);
    }
    ps.stderr.pipe(process.stderr);
    
    ps.on('exit', function (code) {
        if (code !== 0) {
            console.error(stderr);
            console.error(path.join(tmpdir,'invoice.tex'));
            return process.exit(1);
        }
        fs.createReadStream(path.join(tmpdir, 'invoice.pdf'))
            .pipe(fs.createWriteStream(outfile))
        ;
    });
    
    writeConfig(cfg);
}

function writeConfig (cfg) {
    fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2));
}

function prompter (cb) {
    var fields = [ 'name', 'address', 'email', 'currency' ];
    var cfg = {};
    console.log('Gathering configuration options.');
    console.log('Use \\n to denote line-breaks.');
    
    var field = fields.shift();
    process.stdout.write('  ' + field + '> ');
    process.stdin.pipe(split()).pipe(through2(function (line, enc, next) {
        cfg[field] = line.toString('utf8').replace(/\\n/g, '\n');
        
        if (fields.length === 0) {
            cb(null, cfg);
            process.stdin.end();
        }
        else {
            field = fields.shift();
            process.stdout.write('  ' + field + '> ');
            next();
        }
    }));
}

function usage (code) {
    var rs = fs.createReadStream(__dirname + '/usage.txt');
    rs.pipe(process.stdout);
    
    rs.on('close', function () {
        if (code !== 0) process.exit(code);
    });
}

function round (n, ths) {
    return Math.round(n * ths) / ths;
}
