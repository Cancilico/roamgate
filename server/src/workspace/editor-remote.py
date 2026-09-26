# Bundled SSH editor helper. Uses only the Python 3 standard library.
import sys, os, json, hashlib, stat, tempfile, fcntl
LIMIT = 2 * 1024 * 1024
class EditorError(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message

def fail(code, message):
    raise EditorError(code, message)

def path_for(p):
    path = p.get('path')
    if not isinstance(path, str) or not path or '\0' in path:
        fail('INVALID_PATH', 'A file path is required.')
    path = os.path.expanduser(path) if path == '~' or path.startswith('~/') else path
    if not os.path.isabs(path):
        base = p.get('base')
        if not base or not os.path.isabs(base):
            fail('INVALID_PATH', 'Use an absolute path or select a directory first.')
        path = os.path.join(base, path)
    return os.path.normpath(path)

def read(path):
    canonical = os.path.realpath(path)
    fd = os.open(canonical, os.O_RDONLY | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode):
            fail('NOT_EDITABLE', 'Only regular files can be edited.')
        raw = file.read(LIMIT + 1)
    if len(raw) > LIMIT:
        fail('NOT_EDITABLE', 'Editing is limited to 2 MiB.')
    bom = raw.startswith(b'\xef\xbb\xbf')
    try:
        text = (raw[3:] if bom else raw).decode('utf-8')
    except UnicodeError:
        fail('NOT_EDITABLE', 'Only UTF-8 text files can be edited.')
    if '\0' in text:
        fail('NOT_EDITABLE', 'Binary files cannot be edited.')
    stripped = text.replace('\r\n', '')
    if '\r' in stripped or ('\r\n' in text and '\n' in stripped):
        fail('NOT_EDITABLE', 'Mixed or legacy line endings are read only.')
    prefix = '%d:%d:%d:%d:%d:' % (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid)
    return dict(path=path, canonical_path=canonical, text=text.replace('\r\n', '\n'),
                revision=hashlib.sha256(prefix.encode() + raw).hexdigest(),
                bom=bom, newline='crlf' if '\r\n' in text else 'lf'), info

def write(p):
    path = path_for(p)
    expected = p.get('expected_revision', 'MISSING')
    if expected is not None and (not isinstance(expected, str) or not isinstance(p.get('canonical_path'), str)):
        fail('INVALID_REVISION', 'A revision and canonical path are required to replace a file.')
    text = p.get('text')
    if not isinstance(text, str) or '\0' in text or '\r' in text or not isinstance(p.get('bom'), bool) or p.get('newline') not in ('lf', 'crlf'):
        fail('INVALID_CONTENT', 'Invalid UTF-8 text or line endings.')
    raw = (('\ufeff' if p['bom'] else '') + (text.replace('\n', '\r\n') if p['newline'] == 'crlf' else text)).encode('utf-8')
    if len(raw) > LIMIT:
        fail('NOT_EDITABLE', 'Editing is limited to 2 MiB.')
    target = os.path.join(os.path.realpath(os.path.dirname(path)), os.path.basename(path)) if expected is None else p['canonical_path']
    # Directory locks serialize separate SSH invocations without persistent files.
    directory = os.open(os.path.dirname(target), os.O_RDONLY)
    try:
        fcntl.flock(directory, fcntl.LOCK_EX)
        def check():
            if expected is None:
                if os.path.realpath(os.path.dirname(path)) != os.path.dirname(target):
                    fail('CONFLICT', 'The destination directory changed.')
                if os.path.lexists(path):
                    fail('CONFLICT', 'The destination already exists.')
                return None
            try:
                document, info = read(path)
            except FileNotFoundError:
                fail('CONFLICT', 'The file was removed or its link target changed.')
            if document['canonical_path'] != target or document['revision'] != expected:
                fail('CONFLICT', 'The file changed on disk. Compare or reload it before saving.')
            if info.st_nlink > 1:
                fail('NOT_EDITABLE', 'Saving files with multiple hard links is not supported.')
            if not os.access(target, os.W_OK):
                fail('EACCES', 'The destination is not writable.')
            return info
        info = check()
        fd, temporary = tempfile.mkstemp(prefix='.roamgate-', suffix='.tmp', dir=os.path.dirname(target))
        try:
            with os.fdopen(fd, 'wb') as file:
                file.write(raw)
                file.flush()
                if info:
                    temp_info = os.fstat(file.fileno())
                    if (temp_info.st_uid, temp_info.st_gid) != (info.st_uid, info.st_gid):
                        os.fchown(file.fileno(), info.st_uid, info.st_gid)
                    os.fchmod(file.fileno(), stat.S_IMODE(info.st_mode))
                else:
                    mask = os.umask(0)
                    os.umask(mask)
                    os.fchmod(file.fileno(), 0o666 & ~mask)
                os.fsync(file.fileno())
            check()
            if expected is None:
                try:
                    os.link(temporary, target)
                except FileExistsError:
                    fail('CONFLICT', 'The destination already exists.')
            else:
                os.replace(temporary, target)
            return read(path)[0]
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    finally:
        os.close(directory)

try:
    params = json.load(sys.stdin)
    operation = params['operation']
    result = {'path': path_for(params)} if operation == 'path' else read(path_for(params))[0] if operation == 'read' else write(params)
    print(json.dumps({'result': result}))
except Exception as error:
    code = error.code if isinstance(error, EditorError) else 'ENOENT' if isinstance(error, FileNotFoundError) else 'EACCES' if isinstance(error, PermissionError) else 'FILE_ERROR'
    print(json.dumps({'error': {'code': code, 'message': getattr(error, 'message', str(error))}}))
