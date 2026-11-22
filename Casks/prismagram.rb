cask "prismagram" do
  arch arm: "aarch64", intel: "x64"

  version "0.4.3"
  sha256 arm:   "4101763ba7460e052ca3aa3dbdec100c74ee86936b2bc033d41dc9e1f12656e7",
         intel: "1aedfb401a6fbf022f550f8687f7c819fe10b0566d29b2fa771a3d52d54f9161"

  url "https://github.com/Kingvic300/Prismagram/releases/download/v#{version}/Prismagram_#{version}_#{arch}.dmg"
  name "Prismagram"
  desc "Prisma schema diagrams and a database client"
  homepage "https://kingvic300.github.io/Prismagram/"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on macos: ">= :catalina"

  app "Prismagram.app"

  zap trash: "~/Library/Application Support/io.github.kingvic300.prismagram"

  caveats <<~EOS
    Prismagram is not code-signed yet. If macOS says it cannot be opened, run:
      xattr -dr com.apple.quarantine "#{appdir}/Prismagram.app"
  EOS
end
