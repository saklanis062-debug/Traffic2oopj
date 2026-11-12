import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.HashMap;
import java.util.Map;

/** TrafficDensity: converts a total vehicle count into LOW / MEDIUM / HIGH. */
enum TrafficDensity {
    LOW, MEDIUM, HIGH;

    static TrafficDensity fromTotal(int total) {
        if (total < 8) return LOW;
        if (total < 16) return MEDIUM;
        return HIGH;
    }
}

/** TrafficController: the "brain". Decides how long a direction stays green. */
class TrafficController {
    static final int BASE_GREEN = 5;   // seconds given even to an empty road
    static final int MIN_GREEN = 6;
    static final int MAX_GREEN = 20;

    // More waiting vehicles on the roads that are about to get green -> longer green.
    int greenSeconds(int waitingVehicles) {
        int t = BASE_GREEN + (int) Math.round(1.5 * waitingVehicles);
        return Math.max(MIN_GREEN, Math.min(MAX_GREEN, t));
    }
}

/** Main class: a tiny web server. It serves the web files AND answers /api/signal. */
public class traffic {
    static final TrafficController controller = new TrafficController();

    public static void main(String[] args) throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress(8080), 0);
        server.createContext("/api/signal", traffic::handleSignal); // JavaScript calls this
        server.createContext("/", traffic::handleFile);             // serves html/css/js
        server.start();
        System.out.println("Traffic backend running. Open http://localhost:8080");
    }

    // GET /api/signal?north=3&east=5&south=2&west=1&next=NS
    static void handleSignal(HttpExchange ex) throws IOException {
        Map<String, String> q = parse(ex.getRequestURI().getRawQuery());
        int north = num(q, "north"), south = num(q, "south");
        int east = num(q, "east"), west = num(q, "west");
        String next = "EW".equals(q.get("next")) ? "EW" : "NS";

        int total = north + south + east + west;
        int waiting = next.equals("NS") ? north + south : east + west;
        int green = controller.greenSeconds(waiting);
        TrafficDensity density = TrafficDensity.fromTotal(total);

        String json = "{\"total\":" + total + ",\"density\":\"" + density
                + "\",\"greenSeconds\":" + green + ",\"nextGroup\":\"" + next + "\"}";
        send(ex, 200, "application/json", json.getBytes(StandardCharsets.UTF_8));
    }

    static void handleFile(HttpExchange ex) throws IOException {
        String path = ex.getRequestURI().getPath();
        if (path.equals("/")) path = "/traffic.html";
        if (!path.equals("/traffic.html") && !path.equals("/traffic.css") && !path.equals("/traffic.js")) {
            send(ex, 404, "text/plain", "Not found".getBytes(StandardCharsets.UTF_8));
            return;
        }
        String type = path.endsWith(".html") ? "text/html" : path.endsWith(".css") ? "text/css" : "text/javascript";
        try {
            send(ex, 200, type + "; charset=utf-8", Files.readAllBytes(Paths.get(path.substring(1))));
        } catch (IOException e) {
            send(ex, 404, "text/plain", "File missing".getBytes(StandardCharsets.UTF_8));
        }
    }

    static void send(HttpExchange ex, int code, String type, byte[] body) throws IOException {
        ex.getResponseHeaders().add("Content-Type", type);
        ex.getResponseHeaders().add("Cache-Control", "no-cache");
        ex.sendResponseHeaders(code, body.length);
        try (OutputStream os = ex.getResponseBody()) { os.write(body); }
    }

    static Map<String, String> parse(String query) {
        Map<String, String> map = new HashMap<>();
        if (query == null) return map;
        for (String pair : query.split("&")) {
            String[] kv = pair.split("=");
            if (kv.length == 2) map.put(kv[0], kv[1]);
        }
        return map;
    }

    static int num(Map<String, String> q, String key) {
        try { return Math.max(0, Integer.parseInt(q.get(key))); }
        catch (Exception e) { return 0; }
    }
}